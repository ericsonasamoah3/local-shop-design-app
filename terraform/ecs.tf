resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  # Disabled deliberately: Container Insights publishes CloudWatch custom
  # metrics that are billed per metric per month and can easily cost more
  # than the two tasks it is watching. The awslogs groups below are the
  # cheap way to see what these services are doing.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_service_discovery_http_namespace" "main" {
  name = "${var.project_name}.local"
}

resource "aws_cloudwatch_log_group" "backend" {
  name              = "/ecs/${var.project_name}-backend"
  retention_in_days = 3
}

resource "aws_cloudwatch_log_group" "frontend" {
  name              = "/ecs/${var.project_name}-frontend"
  retention_in_days = 3
}

# --- Backend ---

resource "aws_ecs_task_definition" "backend" {
  family                   = "${var.project_name}-backend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.backend_cpu
  memory                   = var.backend_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.backend_task.arn

  volume {
    name = "uploads"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.media.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.uploads.id
        iam             = "ENABLED"
      }
    }
  }

  volume {
    name = "composites"
    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.media.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.composites.id
        iam             = "ENABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name = "backend"
      # Placeholder tag — GitHub Actions overwrites this with the real
      # image URI on every deploy via `aws ecs register-task-definition`.
      image     = "${aws_ecr_repository.backend.repository_url}:latest"
      essential = true
      portMappings = [
        {
          containerPort = var.backend_container_port
          protocol      = "tcp"
          name          = "backend"
        }
      ]
      # Replaces what the ALB target group health check used to do: with
      # no load balancer watching, this is what makes ECS notice a wedged
      # container and cycle the task. busybox wget ships in node:20-alpine.
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O /dev/null http://localhost:${var.backend_container_port}/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
      # Mounted at the exact paths your Dockerfile/app already use for
      # the Compose bind mounts (/app/uploads, /app/composites) — no
      # code changes needed. Adjust these two paths if your Dockerfile
      # uses different ones.
      mountPoints = [
        {
          sourceVolume  = "uploads"
          containerPath = "/app/uploads"
        },
        {
          sourceVolume  = "composites"
          containerPath = "/app/composites"
        }
      ]
      environment = concat(
        [
          { name = "PORT", value = tostring(var.backend_container_port) },
          { name = "REPLICATE_MODEL_VERSION", value = var.replicate_model_version },
        ],
        [for k, v in var.backend_env : { name = k, value = v }]
      )
      # Claude is optional, so its secret is only wired in when a key was
      # supplied. Without it the backend uses the template planning path.
      secrets = concat(
        [
          {
            name      = "REPLICATE_API_TOKEN"
            valueFrom = aws_ssm_parameter.replicate_api_token.arn
          }
        ],
        var.anthropic_api_key == "" ? [] : [
          {
            name      = "ANTHROPIC_API_KEY"
            valueFrom = aws_ssm_parameter.anthropic_api_key[0].arn
          }
        ]
      )
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.backend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "backend"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "backend" {
  name            = "${var.project_name}-backend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.backend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.main.arn

    service {
      port_name      = "backend"
      discovery_name = "backend"
      client_alias {
        port     = var.backend_container_port
        dns_name = "backend"
      }
    }
  }

  # Ignore desired_count so manual scaling isn't clobbered by re-applies,
  # and ignore the task_definition revision since CI updates it directly.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_efs_mount_target.media]
}

# --- Frontend ---

resource "aws_ecs_task_definition" "frontend" {
  family                   = "${var.project_name}-frontend"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.frontend_cpu
  memory                   = var.frontend_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.frontend_task.arn

  container_definitions = jsonencode([
    {
      name      = "frontend"
      image     = "${aws_ecr_repository.frontend.repository_url}:latest"
      essential = true
      portMappings = [
        {
          containerPort = var.frontend_container_port
          protocol      = "tcp"
          name          = "frontend"
        }
      ]
      # Same reasoning as the backend: no ALB health check any more, so the
      # container reports its own liveness. busybox wget ships in nginx:alpine.
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q -O /dev/null http://localhost:${var.frontend_container_port}/ || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
      # No BACKEND_HOST/PORT env vars needed here — nginx.conf already
      # proxies to backend:3001 unchanged, and Service Connect below
      # resolves that exact hostname:port, same as Docker Compose does.
      environment = []
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.frontend.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "frontend"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "frontend" {
  name            = "${var.project_name}-frontend"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.frontend.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.main.arn
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_ssm_parameter" "anthropic_api_key" {
  count = var.anthropic_api_key == "" ? 0 : 1

  name  = "/${var.project_name}/anthropic_api_key"
  type  = "SecureString"
  value = var.anthropic_api_key
}

resource "aws_ssm_parameter" "replicate_api_token" {
  name  = "/${var.project_name}/replicate_api_token"
  type  = "SecureString"
  value = var.replicate_api_token
}

# --- ECS execution role: lets ECS pull images and write logs ---

resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_ssm" {
  name = "read-model-api-secrets"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["ssm:GetParameters"]
      Resource = concat(
        [aws_ssm_parameter.replicate_api_token.arn],
        var.anthropic_api_key == "" ? [] : [aws_ssm_parameter.anthropic_api_key[0].arn],
      )
    }]
  })
}

# --- Backend task role: what the running backend container can do ---

resource "aws_iam_role" "backend_task" {
  name = "${var.project_name}-backend-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "backend_task_efs" {
  name = "efs-media-access"
  role = aws_iam_role.backend_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "elasticfilesystem:ClientMount",
        "elasticfilesystem:ClientWrite",
        "elasticfilesystem:ClientRootAccess",
        "elasticfilesystem:DescribeMountTargets",
      ]
      Resource = aws_efs_file_system.media.arn
      Condition = {
        StringEquals = {
          "elasticfilesystem:AccessPointArn" = [
            aws_efs_access_point.uploads.arn,
            aws_efs_access_point.composites.arn,
            aws_efs_access_point.catalog_areas.arn,
          ]
        }
      }
    }]
  })
}

# --- Frontend task role: no AWS permissions needed, just satisfies
#     the ECS requirement that a task role exist ---

resource "aws_iam_role" "frontend_task" {
  name = "${var.project_name}-frontend-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

# --- GitHub Actions OIDC: lets your workflow assume an AWS role
#     without storing AWS access keys as GitHub secrets ---

resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

resource "aws_iam_role" "github_actions" {
  name = "${var.project_name}-github-actions-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          # Restrict to this repo, any branch/PR. Tighten further to
          # ":ref:refs/heads/main" on both entries if you only ever want
          # main to be able to assume this role.
          #
          # TWO forms, because GitHub changed the subject claim. It now issues
          # IMMUTABLE claims that embed numeric ids:
          #
          #   repo:owner@84795350/repo@1334094868:ref:refs/heads/main
          #
          # rather than the old repo:owner/repo:ref/... . The ids sit in the
          # MIDDLE of the string, so a pattern wildcarded only at the end stops
          # matching entirely and every workflow fails at the AWS login step
          # with "Not authorized to perform sts:AssumeRoleWithWebIdentity".
          # That is exactly what happened on 2026-09-22; CloudTrail's
          # userIdentity.userName shows the claim actually sent.
          #
          # StringLike over a list is OR, so both forms are accepted and the
          # trust survives GitHub rolling the change forward or back. The ids
          # are immutable: renaming the repo or the account does NOT hand trust
          # to whoever claims the old name, which is the point of the change.
          "token.actions.githubusercontent.com:sub" = [
            "repo:${var.github_org}/${var.github_repo}:*",
            "repo:${var.github_org}@${var.github_owner_id}/${var.github_repo}@${var.github_repo_id}:*",
          ]
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_actions" {
  name = "deploy-permissions"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
        ]
        Resource = [aws_ecr_repository.backend.arn, aws_ecr_repository.frontend.arn]
      },
      {
        Effect = "Allow"
        Action = [
          "ecs:DescribeTaskDefinition",
          "ecs:RegisterTaskDefinition",
          "ecs:UpdateService",
          "ecs:DescribeServices",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.ecs_execution.arn, aws_iam_role.backend_task.arn, aws_iam_role.frontend_task.arn]
      },
    ]
  })
}

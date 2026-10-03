# HTTPS entry point: API Gateway HTTP API -> VPC link -> Cloud Map -> the
# frontend task.
#
# Why this exists: browsers only allow the location prompt (Phase 3's "use my
# location") on HTTPS pages, and the app was plain HTTP on a task IP that
# changed every deploy. API Gateway gives a stable
# https://<id>.execute-api.<region>.amazonaws.com URL with an AWS-managed
# certificate and no domain to buy.
#
# Why not an ALB: an ALB is ~$17/mo before traffic and still needs a domain
# for a certificate. At this traffic, this route costs roughly $0.50/mo --
# the Cloud Map private DNS namespace is a Route 53 hosted zone ($0.50/mo),
# VPC links for HTTP APIs are free, and requests are ~$1 per million.
#
# Limits that matter to this app, both fine today:
#   - 10MB payload cap. Uploads are capped at 5MB by the backend.
#   - 30s integration timeout. POST /api/composite returns 202 immediately
#     and the frontend polls, so no single request comes close.

# A private DNS namespace, separate from the HTTP namespace Service Connect
# uses, because API Gateway needs SRV records (IP *and* port) to find the
# task, and ECS only writes those into a DNS namespace.
resource "aws_service_discovery_private_dns_namespace" "ingress" {
  name = "${var.project_name}-ingress.internal"
  vpc  = aws_vpc.main.id
}

resource "aws_service_discovery_service" "frontend" {
  name = "frontend"

  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.ingress.id
    routing_policy = "MULTIVALUE"

    dns_records {
      ttl  = 10
      type = "SRV"
    }
  }

  # ECS reports task health to Cloud Map, so a stopped task is deregistered
  # and API Gateway stops routing to it.
  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_security_group" "vpc_link" {
  name        = "${var.project_name}-vpc-link-sg"
  description = "API Gateway VPC link: may only talk to the frontend port"
  vpc_id      = aws_vpc.main.id

  # By VPC CIDR rather than by the tasks' security group: ecs_tasks already
  # references this group for its ingress, and pointing back would make a
  # cycle. ecs_tasks only admits this port from this group anyway.
  egress {
    description = "To the frontend task"
    from_port   = var.frontend_container_port
    to_port     = var.frontend_container_port
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
}

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "${var.project_name}-vpc-link"
  security_group_ids = [aws_security_group.vpc_link.id]
  subnet_ids         = aws_subnet.public[*].id
}

resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"
  description   = "HTTPS front door for the frontend task"
}

resource "aws_apigatewayv2_integration" "frontend" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = aws_service_discovery_service.frontend.arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id

  # Every request reaches nginx from the VPC link's address, so without this
  # the per-client spend cap in middleware/rateLimit.js would see one client
  # and throttle everyone together. API Gateway stamps the caller's real IP
  # here; nginx.conf trusts this header only from inside the VPC.
  request_parameters = {
    "overwrite:header.x-client-ip" = "$context.identity.sourceIp"
  }
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.frontend.id}"
}

# The $default stage serves at the root, so request paths reach nginx
# unchanged -- a named stage would prefix them (/prod/api/...).
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  # A coarse ceiling on the whole API, in front of the per-client composite
  # cap. Generous for real use; it exists so a runaway client cannot run up
  # request charges.
  default_route_settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50
  }
}

output "alb_dns_name" {
  value       = aws_lb.main.dns_name
  description = "Public URL of the app (add this as an A/CNAME record if you use a domain)"
}

output "ecr_backend_repo_url" {
  value = aws_ecr_repository.backend.repository_url
}

output "ecr_frontend_repo_url" {
  value = aws_ecr_repository.frontend.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_backend_service_name" {
  value = aws_ecs_service.backend.name
}

output "ecs_frontend_service_name" {
  value = aws_ecs_service.frontend.name
}

output "github_actions_role_arn" {
  value       = aws_iam_role.github_actions.arn
  description = "Put this in a GitHub repo variable/secret (e.g. AWS_ROLE_ARN) for the deploy workflow"
}

output "efs_file_system_id" {
  value = aws_efs_file_system.media.id
}

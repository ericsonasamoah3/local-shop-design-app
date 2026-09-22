# The ALB is gone, so there is no longer a stable hostname for the app.
# The frontend task's public IP is the entry point, and it changes on
# every deployment and every task replacement -- so it cannot be a
# Terraform output. Run this to find the current one.
output "app_url_command" {
  description = "Shell command that prints the current frontend URL"
  value       = <<-EOT
    aws ecs list-tasks --cluster ${aws_ecs_cluster.main.name} --service-name ${aws_ecs_service.frontend.name} --region ${var.aws_region} --query 'taskArns[0]' --output text \
      | xargs -I {} aws ecs describe-tasks --cluster ${aws_ecs_cluster.main.name} --tasks {} --region ${var.aws_region} --query 'tasks[0].attachments[0].details[?name==`networkInterfaceId`].value' --output text \
      | xargs -I {} aws ec2 describe-network-interfaces --network-interface-ids {} --region ${var.aws_region} --query 'NetworkInterfaces[0].Association.PublicIp' --output text \
      | xargs -I {} echo "http://{}:${var.frontend_container_port}"
  EOT
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

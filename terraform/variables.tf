variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name used as a prefix on all resources"
  type        = string
  default     = "photoapp"
}

variable "environment" {
  description = "Deployment environment tag"
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "AZs to spread public subnets across"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "backend_container_port" {
  type    = number
  default = 3001
}

variable "frontend_container_port" {
  type    = number
  default = 3000
}

variable "backend_cpu" {
  type    = number
  default = 256
}

variable "backend_memory" {
  type    = number
  default = 512
}

variable "frontend_cpu" {
  type    = number
  default = 256
}

variable "frontend_memory" {
  type    = number
  default = 512
}

variable "github_org" {
  description = "GitHub org/user that owns the repo (for OIDC trust policy)"
  type        = string
}

variable "github_repo" {
  description = "GitHub repo name (for OIDC trust policy)"
  type        = string
}

variable "replicate_api_token" {
  description = "Replicate API token, injected into the backend task as a secret"
  type        = string
  sensitive   = true
}

variable "replicate_model_version" {
  type    = string
  default = ""
}

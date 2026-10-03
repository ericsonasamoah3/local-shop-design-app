variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "eu-north-1"
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
  description = "AZs to place public subnets in. Two were required by the ALB; with it gone, one is enough and avoids a second EFS mount target plus cross-AZ traffic."
  type        = list(string)
  default     = ["eu-north-1a"]
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

variable "anthropic_api_key" {
  description = "Optional. Anthropic API key for the composite planning step. Leave empty to run without Claude -- the backend falls back to the user's own rectangle and a template prompt."
  type        = string
  sensitive   = true
  default     = ""
}

variable "replicate_api_token" {
  description = "Replicate API token, injected into the backend task as a secret"
  type        = string
  sensitive   = true
}

variable "replicate_model_version" {
  description = "Either an owner/name slug for an official hosted model, or a 64-hex community version hash"
  type        = string
  default     = ""
}

variable "backend_env" {
  description = <<-EOT
    Extra plain environment variables for the backend task, e.g. the
    REPLICATE_FIELD_* overrides for the chosen model and MAX_RENDER_EDGE.
    Set a REPLICATE_FIELD_* key to "" to omit that input field entirely --
    required for mask-only models such as black-forest-labs/flux-fill-pro.
  EOT
  type        = map(string)
  default     = {}
}

# The model and its input field names are a pair. replicate_model_version can
# be overridden from a GitHub repo variable without a commit, but backend_env
# lives in ci.auto.tfvars -- so an override can leave the two describing
# different models. That is not hypothetical: sending flux-fill-pro a
# reference-image field it does not declare makes Replicate reject every
# request, which is how production compositing broke.
#
# A check block warns on plan (and in the PR comment) rather than failing the
# apply, because only the model's own schema is authoritative and this list
# cannot stay exhaustive.
locals {
  # Models that accept image + mask + prompt and nothing else.
  mask_only_models = [
    "black-forest-labs/flux-fill-pro",
    "black-forest-labs/flux-fill-dev",
  ]

  model_is_mask_only   = contains(local.mask_only_models, var.replicate_model_version)
  reference_field_sent = lookup(var.backend_env, "REPLICATE_FIELD_REFERENCE", "ip_adapter_image") != ""
}

check "model_field_mapping" {
  assert {
    condition     = !(local.model_is_mask_only && local.reference_field_sent)
    error_message = <<-EOT
      ${var.replicate_model_version} is mask-only, but backend_env does not
      blank REPLICATE_FIELD_REFERENCE. The backend will send a reference-image
      field the model does not declare and Replicate will reject every
      composite request. Set REPLICATE_FIELD_REFERENCE = "" in
      terraform/ci.auto.tfvars, or switch to a reference-capable model.
    EOT
  }
}

# GitHub's immutable OIDC claims embed these numeric ids in the subject, so the
# role trust policy needs them. They never change -- not on a rename, not on a
# transfer, which is the point. Find them with:
#   gh api repos/OWNER/REPO --jq '"\(.owner.id) \(.id)"'
variable "github_owner_id" {
  description = "Numeric GitHub account id, used in the immutable OIDC subject claim"
  type        = string
}

variable "github_repo_id" {
  description = "Numeric GitHub repository id, used in the immutable OIDC subject claim"
  type        = string
}

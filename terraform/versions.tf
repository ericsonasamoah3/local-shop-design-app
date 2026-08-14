terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state — uncomment and fill in once you've created this bucket
  # by hand (one-time, chicken-and-egg problem: state storage can't
  # manage itself). See README for the one-time bootstrap commands.
  #
  # use_lockfile enables S3's native conditional-write locking
  # (Terraform >= 1.10) — no DynamoDB table needed.
  #
  backend "s3" {
    bucket       = "local-shop-design-app-tfstate-258506450105"
    key          = "app/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.aws_region
}

# Permissions for Terraform running in GitHub Actions.
#
# Separate from deploy-permissions in iam.tf on purpose: that policy is the
# narrow set the app deploy needs (push an image, update a service). This one
# is what managing the whole stack from CI requires, and it is much broader.
#
# UNDERSTAND WHAT THIS GRANTS. Anyone who can push to this repo -- or land a
# workflow change -- can make this role create, modify and DELETE the network,
# the file system holding every upload and composite, the secrets, and the IAM
# roles themselves. The iam:* grant below is in particular a path to full
# account admin: a role that can write role policies can write itself a better
# one. That is inherent to letting CI apply Terraform, not something this file
# can design away.
#
# Two things materially reduce the blast radius, neither enabled here:
#   - restrict the trust policy in iam.tf to refs/heads/main only, so a pull
#     request from a fork cannot assume this role;
#   - require a GitHub environment with a manual approval on the apply job.
#
# The alternative is plan-only in CI with apply run locally, which needs just
# the s3 statement below plus Describe/Get/List.

data "aws_caller_identity" "current" {}

variable "tfstate_bucket" {
  description = "S3 bucket holding Terraform remote state. Must match the backend block in versions.tf, which cannot read variables."
  type        = string
  default     = "local-shop-design-app-tfstate-258506450105"
}

resource "aws_iam_role_policy" "github_actions_terraform" {
  name = "terraform-permissions"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      # Remote state. The 403 that broke every Terraform run was this missing:
      # the role had ECR and ECS permissions and nothing for S3 at all.
      # ListBucket is on the BUCKET arn, object actions on the KEY arn --
      # getting that split wrong is the usual cause of a puzzling 403.
      {
        Sid      = "TerraformStateBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation"]
        Resource = "arn:aws:s3:::${var.tfstate_bucket}"
      },
      {
        Sid    = "TerraformStateObjects"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        # The .tflock entry is S3 native locking (use_lockfile in versions.tf).
        # Without it Terraform acquires no lock and fails before touching state.
        Resource = [
          "arn:aws:s3:::${var.tfstate_bucket}/app/terraform.tfstate",
          "arn:aws:s3:::${var.tfstate_bucket}/app/terraform.tfstate.tflock",
        ]
      },

      # The stack's own services. Service-level wildcards rather than an
      # enumerated action list: an apply that dies half way through on one
      # missing verb leaves infrastructure in a worse state than it started.
      {
        Sid    = "ManageStack"
        Effect = "Allow"
        Action = [
          "ec2:*",
          "ecs:*",
          "ecr:*",
          "elasticfilesystem:*",
          "servicediscovery:*",
          "logs:*",
        ]
        Resource = "*"
      },

      # Secrets. Scoped to this project's parameter path.
      {
        Sid    = "ManageParameters"
        Effect = "Allow"
        Action = [
          "ssm:PutParameter",
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:DeleteParameter",
          "ssm:DescribeParameters",
          "ssm:AddTagsToResource",
          "ssm:RemoveTagsFromResource",
          "ssm:ListTagsForResource",
        ]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/${var.project_name}/*"
      },
      {
        # DescribeParameters does not accept a resource scope.
        Sid      = "DescribeParameters"
        Effect   = "Allow"
        Action   = ["ssm:DescribeParameters"]
        Resource = "*"
      },

      # IAM, scoped to this project's own roles and the OIDC provider so the
      # role cannot rewrite unrelated roles in the account. This is the
      # narrowest form that still lets Terraform manage what it created.
      {
        Sid    = "ManageProjectRoles"
        Effect = "Allow"
        Action = [
          "iam:CreateRole",
          "iam:DeleteRole",
          "iam:GetRole",
          "iam:TagRole",
          "iam:UntagRole",
          "iam:UpdateAssumeRolePolicy",
          "iam:PutRolePolicy",
          "iam:GetRolePolicy",
          "iam:DeleteRolePolicy",
          "iam:ListRolePolicies",
          "iam:AttachRolePolicy",
          "iam:DetachRolePolicy",
          "iam:ListAttachedRolePolicies",
          "iam:ListInstanceProfilesForRole",
        ]
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/${var.project_name}-*"
      },
      {
        Sid    = "ManageOidcProvider"
        Effect = "Allow"
        Action = [
          "iam:CreateOpenIDConnectProvider",
          "iam:DeleteOpenIDConnectProvider",
          "iam:GetOpenIDConnectProvider",
          "iam:TagOpenIDConnectProvider",
          "iam:UpdateOpenIDConnectProviderThumbprint",
          "iam:AddClientIDToOpenIDConnectProvider",
          "iam:RemoveClientIDFromOpenIDConnectProvider",
        ]
        Resource = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/*"
      },
      {
        # List calls do not accept a resource scope. Read-only.
        Sid      = "ReadIamListings"
        Effect   = "Allow"
        Action   = ["iam:ListOpenIDConnectProviders", "iam:ListRoles", "iam:ListPolicies"]
        Resource = "*"
      },
      {
        # The AWS-managed execution policy Terraform attaches to the exec role.
        Sid      = "ReadManagedPolicy"
        Effect   = "Allow"
        Action   = ["iam:GetPolicy", "iam:GetPolicyVersion", "iam:ListPolicyVersions"]
        Resource = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
      },
      {
        # Fargate and EFS need their service-linked roles to exist.
        Sid      = "CreateServiceLinkedRoles"
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole"]
        Resource = "*"
        Condition = {
          StringEquals = {
            "iam:AWSServiceName" = [
              "ecs.amazonaws.com",
              "elasticfilesystem.amazonaws.com",
            ]
          }
        }
      },
    ]
  })
}

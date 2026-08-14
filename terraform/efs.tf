# Replaces the ./backend/uploads and ./backend/composites bind mounts.
# Two access points on one filesystem, mounted into the backend
# container at the exact same paths Docker Compose uses today
# (/app/uploads, /app/composites) — no backend code changes needed.

resource "aws_efs_file_system" "media" {
  creation_token   = "${var.project_name}-media"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  tags = {
    Name = "${var.project_name}-media"
  }
}

resource "aws_efs_mount_target" "media" {
  count           = length(aws_subnet.public)
  file_system_id  = aws_efs_file_system.media.id
  subnet_id       = aws_subnet.public[count.index].id
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "uploads" {
  file_system_id = aws_efs_file_system.media.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/uploads"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "755"
    }
  }
}

resource "aws_efs_access_point" "composites" {
  file_system_id = aws_efs_file_system.media.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/composites"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "755"
    }
  }
}

resource "aws_security_group" "efs" {
  name        = "${var.project_name}-efs-sg"
  description = "Allow NFS from ECS tasks"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "NFS from ECS tasks"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

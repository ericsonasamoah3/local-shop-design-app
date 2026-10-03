resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "${var.project_name}-vpc"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.project_name}-igw"
  }
}

# Public subnets only -- Fargate tasks get public IPs directly, no NAT
# gateway. Since the ALB was removed, the frontend task's own public IP
# is the entry point, so a single AZ is enough (an ALB would have
# required two). Add AZs back to var.availability_zones if you
# reintroduce a load balancer.
resource "aws_subnet" "public" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.main.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-public-${count.index}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.project_name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count          = length(var.availability_zones)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "ecs_tasks" {
  name        = "${var.project_name}-ecs-tasks-sg"
  # Out of date -- public traffic now arrives via API Gateway -- but AWS
  # cannot edit a security group's description, and replacing a group that
  # running tasks and EFS are attached to is not worth a corrected label.
  description = "Allow public traffic to the frontend and traffic between services"
  vpc_id      = aws_vpc.main.id

  # The only way in is the API Gateway VPC link (https.tf). The tasks keep
  # public IPs because they need outbound internet with no NAT gateway, but
  # nothing on the internet can reach them directly any more. That matters
  # beyond tidiness: nginx trusts the x-client-ip header the spend cap keys
  # on, and that is only safe while API Gateway is the sole route to it.
  ingress {
    description     = "HTTP from the API Gateway VPC link"
    from_port       = var.frontend_container_port
    to_port         = var.frontend_container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.vpc_link.id]
  }

  ingress {
    description = "Between frontend and backend services via Service Connect"
    from_port   = 0
    to_port     = 65535
    protocol    = "tcp"
    self        = true
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

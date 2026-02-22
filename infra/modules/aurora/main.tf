resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-aurora"
  subnet_ids = var.subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name}-aurora"
  })
}

resource "aws_rds_cluster_parameter_group" "this" {
  name   = "${var.name}-aurora-pg15"
  family = "aurora-postgresql15"

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  tags = var.tags
}

resource "aws_rds_cluster" "this" {
  cluster_identifier = var.name
  engine             = "aurora-postgresql"
  engine_version     = var.engine_version

  db_subnet_group_name            = aws_db_subnet_group.this.name
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name
  vpc_security_group_ids          = var.security_group_ids

  manage_master_user_password = true
  master_username             = "postgres"

  storage_encrypted = true
  deletion_protection = false

  # Skip final snapshot in dev; override for prod via lifecycle or wrapper
  skip_final_snapshot       = true
  final_snapshot_identifier = "${var.name}-final"

  tags = var.tags
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.name}-writer"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = var.instance_class
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  publicly_accessible = false

  tags = var.tags
}

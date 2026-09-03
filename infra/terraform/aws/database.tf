resource "aws_kms_key" "facility" {
  description             = "Facility control-plane data"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "facility" {
  name          = "alias/${local.name_prefix}"
  target_key_id = aws_kms_key.facility.key_id
}

resource "aws_db_subnet_group" "facility" {
  name       = local.name_prefix
  subnet_ids = [for subnet in aws_subnet.private : subnet.id]
}

resource "aws_db_instance" "facility" {
  identifier = "${local.name_prefix}-postgres"

  engine         = "postgres"
  engine_version = "16"
  instance_class = var.database_instance_class

  allocated_storage     = var.database_allocated_storage_gb
  max_allocated_storage = max(var.database_allocated_storage_gb, 100)
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.facility.arn

  db_name  = "facility"
  username = "facility"

  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.facility.arn

  db_subnet_group_name   = aws_db_subnet_group.facility.name
  vpc_security_group_ids = [aws_security_group.database.id]
  publicly_accessible    = false

  backup_retention_period   = var.database_backup_retention_days
  deletion_protection       = var.enable_deletion_protection
  skip_final_snapshot       = !var.enable_deletion_protection
  final_snapshot_identifier = var.enable_deletion_protection ? "${local.name_prefix}-final" : null

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.facility.arn
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  auto_minor_version_upgrade      = true
  apply_immediately               = true
  copy_tags_to_snapshot           = true
  monitoring_interval             = 0
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${local.name_prefix}/runtime"
  description             = "Facility runtime configuration stored as one JSON object"
  kms_key_id              = aws_kms_key.facility.arn
  recovery_window_in_days = 30
}

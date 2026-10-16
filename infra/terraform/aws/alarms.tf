locals {
  operations_namespace = "Facility/${var.environment}"
}

# Gauges come from the worker's facility.operations log line: ages and counts
# only, never turn text or webhook bodies. Queue age also covers a dead worker,
# because a missing sample is a breach.

resource "aws_cloudwatch_log_metric_filter" "queue_age" {
  name           = "${local.name_prefix}-queue-age"
  log_group_name = aws_cloudwatch_log_group.service["worker"].name
  pattern        = "{ $.event = \"facility.operations\" }"

  metric_transformation {
    name      = "QueueAgeSeconds"
    namespace = local.operations_namespace
    value     = "$.queueAgeSeconds"
    unit      = "Seconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "failed_turns" {
  name           = "${local.name_prefix}-failed-turns"
  log_group_name = aws_cloudwatch_log_group.service["worker"].name
  pattern        = "{ $.event = \"facility.operations\" }"

  metric_transformation {
    name      = "FailedTurns"
    namespace = local.operations_namespace
    value     = "$.failedTurns"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "webhook_rejections" {
  name           = "${local.name_prefix}-webhook-rejections"
  log_group_name = aws_cloudwatch_log_group.service["worker"].name
  pattern        = "{ $.event = \"facility.operations\" }"

  metric_transformation {
    name      = "WebhookRejections"
    namespace = local.operations_namespace
    value     = "$.webhookRejections"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_log_metric_filter" "mirror_lag" {
  name           = "${local.name_prefix}-mirror-lag"
  log_group_name = aws_cloudwatch_log_group.service["worker"].name
  pattern        = "{ $.event = \"facility.operations\" }"

  metric_transformation {
    name      = "MirrorLagSeconds"
    namespace = local.operations_namespace
    value     = "$.mirrorLagSeconds"
    unit      = "Seconds"
  }
}

resource "aws_cloudwatch_log_metric_filter" "budgets_exceeded" {
  name           = "${local.name_prefix}-budgets-exceeded"
  log_group_name = aws_cloudwatch_log_group.service["worker"].name
  pattern        = "{ $.event = \"facility.operations\" }"

  metric_transformation {
    name      = "BudgetsExceeded"
    namespace = local.operations_namespace
    value     = "$.budgetsExceeded"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  alarm_name          = "${local.name_prefix}-queue-age"
  alarm_description   = "Oldest due turn is older than two minutes, or the worker stopped reporting."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "QueueAgeSeconds"
  namespace           = local.operations_namespace
  period              = 60
  statistic           = "Maximum"
  threshold           = 120
  treat_missing_data  = "breaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "failed_turns" {
  alarm_name          = "${local.name_prefix}-failed-turns"
  alarm_description   = "One or more turns failed in the current sample window."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedTurns"
  namespace           = local.operations_namespace
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "webhook_rejections" {
  alarm_name          = "${local.name_prefix}-webhook-rejections"
  alarm_description   = "GitHub webhook deliveries were rejected before they were stored."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "WebhookRejections"
  namespace           = local.operations_namespace
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "mirror_lag" {
  alarm_name          = "${local.name_prefix}-mirror-lag"
  alarm_description   = "GitHub reconciliation for an active project is more than 30 minutes behind."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "MirrorLagSeconds"
  namespace           = local.operations_namespace
  period              = 60
  statistic           = "Maximum"
  threshold           = 1800
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

resource "aws_cloudwatch_metric_alarm" "budgets_exceeded" {
  alarm_name          = "${local.name_prefix}-budgets-exceeded"
  alarm_description   = "An enabled project budget is exhausted for the current month."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "BudgetsExceeded"
  namespace           = local.operations_namespace
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = var.alarm_action_arns
  ok_actions          = var.alarm_action_arns
}

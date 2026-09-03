# Facility AWS control plane

This module runs Facility's durable control plane on AWS while every story workspace runs on
Vercel Sandbox. It provisions one ALB, ECS services for API/MCP/webhooks, worker, and web, an RDS
PostgreSQL database, ECR repositories, Secrets Manager, and CloudWatch logs.

It does not provision a model gateway, CodeBuild sandboxes, preview tasks, or a separate metering
service. Cost controls, audit events, observability, GitHub mirroring, and the delivery pipeline are
handled by the API, worker, and PostgreSQL.

See the [AWS deployment guide](../../../apps/docs/docs/self-host/aws.md) for the complete bootstrap
and release sequence.

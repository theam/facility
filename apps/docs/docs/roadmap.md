---
title: Roadmap
---

# Roadmap

This page separates capabilities that exist from direction that is planned.
Roadmap items have no committed date until they move into a release plan.

## Native preview environments

**Status: planned.** Fast human validation is a core part of the Facility
loop, but Facility does not currently create live preview environments.
Projects must enable their deployment provider's per-PR preview capability
today and require the preview URL and deployment status on the pull request.

Facility's native preview system is intended to:

- create an isolated live environment for every implementation pull request;
- support provider adapters rather than bind the control plane to one cloud;
- attach the URL, deployment status, and expiry to the Facility run and PR;
- support project-defined provisioning, seeded test data, and access policy;
- make preview readiness part of Gate 2 evidence; and
- destroy the environment when the PR closes or its retention window expires.

Until this ships, Facility treats an external provider's preview as the live
validation surface and GitHub as the Gate 2 review and merge boundary.

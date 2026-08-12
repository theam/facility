import type { FastifyInstance } from "fastify";
import { DoctorResponseSchema, runReadinessDoctor } from "../../doctor.js";
import { principal, type V1RouteContext } from "./shared.js";

export async function registerAdminDoctorRoutes(app: FastifyInstance, context: V1RouteContext) {
  app.get(
    "/v1/admin/doctor",
    {
      config: { permission: "org:write", orgAdmin: true },
      schema: { response: { 200: DoctorResponseSchema } },
    },
    async (request) => {
      const p = principal(request);
      return runReadinessDoctor({
        db: context.db,
        config: context.config,
        orgId: p.orgId,
        githubAppMetadataReader: app.githubAppMetadataReader,
      });
    },
  );
}

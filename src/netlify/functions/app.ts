import type { Config } from "@netlify/functions";
import { handleNetlifyAppRequest } from "../app.js";

export default async (req: Request): Promise<Response> => handleNetlifyAppRequest(req);

export const config: Config = {
  path: [
    "/",
    "/submit",
    "/dashboard",
    "/submissions/:id",
    "/r/:token",
    "/outputs/:runId",
    "/api/runs",
    "/api/runs/:runId",
    "/api/runs/:runId/artifacts/:fileName"
  ]
};

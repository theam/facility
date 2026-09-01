declare module "oidc-provider" {
  type InteractionDetails = {
    params?: Record<string, unknown>;
    grantId?: string;
  };

  interface GrantInstance {
    addOIDCScope(scope: string): void;
    rejectOIDCScope(scope: string): void;
    addResourceScope(resource: string, scope: string): void;
    save(): Promise<string>;
  }

  export default class Provider {
    constructor(issuer: string, configuration: Record<string, unknown>);
    proxy: boolean;
    callback(): (
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ) => void;
    interactionDetails(
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
    ): Promise<InteractionDetails>;
    interactionFinished(
      req: import("node:http").IncomingMessage,
      res: import("node:http").ServerResponse,
      result: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<void>;
    Grant: {
      new (input: Record<string, unknown>): GrantInstance;
      find(id: string): Promise<GrantInstance | undefined>;
    };
  }
}

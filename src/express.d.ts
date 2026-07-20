import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    gatewayClientId?: string;
    requestId?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      gatewayClientId?: string;
      requestId?: string;
    }
  }
}

export {};

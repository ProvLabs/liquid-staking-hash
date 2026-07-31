// Minimal ambient types for the `web-push` package. Declared
// locally rather than adding `@types/web-push`, so the milestone keeps its
// single named dependency (`web-push`). Covers exactly the surface the notifier
// fan-out uses (`notifier/push.ts`).

declare module "web-push" {
  interface PushSubscriptionJSON {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }
  interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }
  interface RequestOptions {
    vapidDetails?: VapidDetails;
    TTL?: number;
    timeout?: number;
  }
  interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }
  function sendNotification(
    subscription: PushSubscriptionJSON,
    payload?: string | Buffer,
    options?: RequestOptions,
  ): Promise<SendResult>;
  function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  const _default: {
    sendNotification: typeof sendNotification;
    setVapidDetails: typeof setVapidDetails;
  };
  export default _default;
  export { sendNotification, setVapidDetails };
}

export type ProviderId = 'mock' | 'twilio' | 'aliyun' | 'pushplus' | 'ihuyi' | 'ronglian' | 'sip';
export type EventType = 'task_completed' | 'task_failed' | 'task_stalled' | 'retry_exhausted' | 'decision_required' | 'turn_finished';
export interface DecisionOption { id: string; label: string }
export interface AgentEventInput {
  eventId: string; taskId: string; source: string; type: EventType; summary: string;
  occurredAt?: string; threadId?: string; sessionId?: string;
  evidence?: { kind: 'agent_report' | 'verified'; description: string };
  decision?: { question: string; options: DecisionOption[]; expiresInSeconds?: number };
}
export interface AppConfig {
  mode: ProviderId;
  recipient: { countryCode: string; number: string; consent: boolean };
  voice: { name: string; rate: number };
  notification: { enabled: boolean; types: EventType[]; cooldownSeconds: number; maxPerHour: number; maxPerDay: number; stallMinutes: number; maxRetries: number };
  providers: {
    twilio: { accountSid: string; authToken: string; from: string; callbackBaseUrl: string };
    aliyun: { accessKeyId: string; accessKeySecret: string; ttsCode: string; regionId: string };
    pushplus: { token: string; secretKey: string };
    ihuyi: { apiId: string; apiKey: string; templateId: string };
    ronglian: { accountSid: string; authToken: string; appId: string; templateText: string };
    sip: { server: string; username: string; password: string; extension: string; port: number; transport: string; executable: string };
  };
  controlPin: string;
}
export interface CallRequest {
  notificationId: string; eventId: string; taskId: string; to: string; text: string;
  eventType?: EventType;
  decision?: { id: string; question: string; options: DecisionOption[] };
}
export interface CallResult {
  status: 'accepted' | 'completed' | 'failed' | 'unknown';
  callId?: string; retryable?: boolean; message?: string; rawCode?: string;
}
export interface CheckResult { ok: boolean; message: string; checks?: { name: string; ok: boolean; detail: string }[] }
export interface CallProvider {
  id: ProviderId;
  check(config: AppConfig, options?: { remote?: boolean }): Promise<CheckResult>;
  dial(request: CallRequest, config: AppConfig, options?: { signal?: AbortSignal }): Promise<CallResult>;
  cancel(callId: string, config: AppConfig): Promise<CheckResult>;
  shutdown?(): Promise<CheckResult>;
  poll?(callId: string, config: AppConfig, createdAt: string): Promise<CallResult>;
}

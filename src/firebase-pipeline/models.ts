// ===== Firebase Phone-Registration Pipeline — Models =====
// Typed models and error values for the surgical rewrite.

export type PipelineState =
  | 'pending'
  | 'assigned'
  | 'otp_sent'
  | 'active'
  | 'registering'
  | 'registered'
  | 'failed'
  | 'retry_queue';

export type KeyStatus = 'healthy' | 'throttled' | 'slow' | 'quarantined' | 'failed';

export interface PipelineConfig {
  poolSize: number; // 100 concurrent
  keyCap: number; // 8 per key
  backoffFloor: number; // ms
  backoffCeiling: number; // ms
  defaultCountryCode: string; // 91
  rescanInterval: number; // ms
  pipelineDb: string; // SQLite path
  maskSecrets: boolean;
}

export interface FirebaseKey {
  id: string; // AIza... (39 chars)
  score: number; // 0-100
  status: KeyStatus;
  lastUsed: number;
  usageCount: number;
  cap: number; // 8
  quarantineUntil: number;
  createdAt: number;
}

export interface NumberEntry {
  id: string; // UUID or hash
  phone: string; // E.164 normalized
  state: PipelineState;
  assignedKeyId?: string;
  otpCode?: string;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

export interface DashboardStats {
  pending: number;
  assigned: number;
  otpSent: number;
  active: number;
  registering: number;
  registered: number;
  failed: number;
  retryQueue: number;
  totalKeys: number;
  healthyKeys: number;
  quarantinedKeys: number;
  throughput: number; // per second
  lastError?: string;
}

export interface RetryPolicy {
  floor: number;
  ceiling: number;
  jitter: number;
  maxAttempts: number;
}

// Error values
export const ERR_KEY_QUARANTINED = 'ERR_KEY_QUARANTINED';
export const ERR_KEY_FAILED = 'ERR_KEY_FAILED';
export const ERR_OTP_TIMEOUT = 'ERR_OTP_TIMEOUT';
export const ERR_REGISTRATION_FAILED = 'ERR_REGISTRATION_FAILED';
export const ERR_INVALID_NUMBER = 'ERR_INVALID_NUMBER';
export const ERR_DUPLICATE = 'ERR_DUPLICATE';
export const ERR_MAX_ATTEMPTS = 'ERR_MAX_ATTEMPTS';
export const ERR_ABORTED = 'ERR_ABORTED';

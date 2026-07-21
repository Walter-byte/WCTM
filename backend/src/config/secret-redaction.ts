import {
  guardSensitiveSerialization,
  redactSensitiveData,
} from '../common/utils/redact-sensitive-data';

export { REDACTED_VALUE } from '../common/utils/redact-sensitive-data';

export const redactSecrets = redactSensitiveData;
export const guardSecretSerialization = guardSensitiveSerialization;

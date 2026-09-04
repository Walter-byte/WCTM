import { runSecurityConfigAudit } from './security-config-audit';

const result = runSecurityConfigAudit(process.env);

process.stdout.write(`${result.lines.join('\n')}\n`);
process.exitCode = result.passed ? 0 : 1;

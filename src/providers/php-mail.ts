import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export interface EmailMessage {
  to: string;
  from: 'NYC Alert <noreply@nycalert.ai>';
  subject: string;
  text: string;
  html: string;
}

const phpMailScript = `
$message = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$headers = "From: " . $message['from'] . "\\r\\nMIME-Version: 1.0\\r\\nContent-Type: multipart/alternative; boundary=\\\"" . $message['boundary'] . "\\\"";
if (!mail($message['to'], $message['subject'], $message['body'], $headers, '-f noreply@nycalert.ai')) {
    fwrite(STDERR, 'PHP mail() rejected the message.');
    exit(1);
}
`;

export function buildMailBody(message: Pick<EmailMessage, 'text' | 'html'>): { boundary: string; body: string } {
  const boundary = `nycalert_${randomBytes(16).toString('hex')}`;
  const part = (type: string, content: string): string => {
    const normalized = content.replace(/\r\n|\r|\n/g, '\r\n');
    const encoded = Buffer.from(normalized, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
    return `--${boundary}\r\nContent-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n`;
  };
  // Encode before Postfix/OpenDKIM sees the body, preventing SMTP line wrapping
  // and 8-bit downgrades from changing content after the signature is created.
  return { boundary, body: part('text/plain', message.text) + part('text/html', message.html) + `--${boundary}--\r\n` };
}

export function sendPhpMail(message: EmailMessage): Promise<void> {
  const binaries = [process.env.PHP_MAIL_BINARY, '/usr/bin/php', 'php'].filter((value, index, list): value is string => {
    if (!value || !value.trim()) return false;
    return list.indexOf(value) === index;
  });

  return new Promise((resolve, reject) => {
    const errors: string[] = [];
    const tryBinary = (index: number): void => {
      if (index >= binaries.length) {
        reject(new Error(errors.join(' | ') || 'No PHP binary was available for mail delivery.'));
        return;
      }
      const binary = binaries[index]!;
      const child = spawn(binary, ['-r', phpMailScript], {
        stdio: ['pipe', 'ignore', 'pipe']
      });
      let errorOutput = '';
      let failedToSpawn = false;
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { errorOutput += chunk; });
      child.once('error', (error) => {
        failedToSpawn = true;
        errors.push(`${binary}: ${error.message}`);
        tryBinary(index + 1);
      });
      child.once('close', (code) => {
        if (failedToSpawn) return;
        if (code === 0) {
          resolve();
          return;
        }
        errors.push(`${binary}: ${errorOutput.trim() || `exit ${code ?? 'unknown'}`}`);
        reject(new Error(errors.join(' | ')));
      });
      child.stdin.end(JSON.stringify({ to: message.to, from: message.from, subject: message.subject, ...buildMailBody(message) }));
    };
    tryBinary(0);
  });
}
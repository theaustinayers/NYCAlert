import { spawn } from 'node:child_process';

export interface EmailMessage {
  to: string;
  from: 'NYC Alert <noreply@nycalert.ai>';
  subject: string;
  text: string;
  html: string;
}

const phpMailScript = `
$message = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$boundary = 'nycalert_' . bin2hex(random_bytes(16));
$headers = "From: " . $message['from'] . "\\r\\nMIME-Version: 1.0\\r\\nContent-Type: multipart/alternative; boundary=\\\"" . $boundary . "\\\"";
$body = "--" . $boundary . "\\r\\nContent-Type: text/plain; charset=UTF-8\\r\\nContent-Transfer-Encoding: 8bit\\r\\n\\r\\n"
    . $message['text'] . "\\r\\n--" . $boundary . "\\r\\nContent-Type: text/html; charset=UTF-8\\r\\nContent-Transfer-Encoding: 8bit\\r\\n\\r\\n"
    . $message['html'] . "\\r\\n--" . $boundary . "--\\r\\n";
if (!mail($message['to'], $message['subject'], $body, $headers, '-f noreply@nycalert.ai')) {
    fwrite(STDERR, 'PHP mail() rejected the message.');
    exit(1);
}
`;

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
      child.stdin.end(JSON.stringify(message));
    };
    tryBinary(0);
  });
}
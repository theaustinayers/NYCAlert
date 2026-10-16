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
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PHP_MAIL_BINARY || 'php', ['-r', phpMailScript], {
      stdio: ['pipe', 'ignore', 'pipe']
    });
    let errorOutput = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { errorOutput += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || `PHP mail process exited with status ${code ?? 'unknown'}.`));
    });
    child.stdin.end(JSON.stringify(message));
  });
}
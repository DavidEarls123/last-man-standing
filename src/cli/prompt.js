import readline from 'node:readline';

export function ask(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (silent) {
      // Suppress echo while a password is typed.
      const originalWrite = rl._writeToOutput?.bind(rl);
      rl._writeToOutput = (text) => {
        if (text.includes(question)) originalWrite?.(text);
        else rl.output.write('*');
      };
    }
    rl.question(question, (answer) => {
      if (silent) rl.output.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

export const flag = (name, fallback = undefined) => {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (match) return match.slice(name.length + 3);
  return process.argv.includes(`--${name}`) ? true : fallback;
};

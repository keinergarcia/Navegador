#!/usr/bin/env node
// Utilidades de línea de comandos. No importa config.js para poder ejecutarse
// durante la instalación, antes de que .env esté completo.
import { randomBytes } from "node:crypto";
import process from "node:process";

import { hashPassword } from "./auth.js";

const command = process.argv[2];

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

switch (command) {
  case "hash-password": {
    const raw = await readStdin();
    // Solo se elimina el salto de línea final que añade `read`.
    const password = raw.replace(/\r?\n$/, "");
    if (password.length < 12) {
      process.stderr.write("La contraseña debe tener al menos 12 caracteres\n");
      process.exit(1);
    }
    process.stdout.write(`${await hashPassword(password)}\n`);
    break;
  }
  case "gen-secret": {
    process.stdout.write(`${randomBytes(32).toString("hex")}\n`);
    break;
  }
  default:
    process.stderr.write(
      "Uso:\n" +
        "  node src/cli.js hash-password   (lee la contraseña por stdin)\n" +
        "  node src/cli.js gen-secret\n",
    );
    process.exit(1);
}

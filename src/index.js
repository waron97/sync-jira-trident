#!/usr/bin/env node

import dotenv from "dotenv";
dotenv.config();

import { Command } from "commander";
import { runCommand } from "./commands/run.js";
import { generateCommand } from "./commands/generate.js";

const program = new Command();
program.name("jirasync").description("Sync Jira issues to Trident").version("1.0.0");

program
  .command("run")
  .description("Fetch filtered Jira issues and write JSON")
  .option("-o, --output <path>", "output JSON file path", "output.json")
  .action(runCommand);

program
  .command("generate <key>")
  .description("Fetch single Jira issue by key and create Trident task if not exists")
  .action(generateCommand);

program
  .command("start")
  .description("Run sync loop every 10 minutes")
  .option("-o, --output <path>", "output JSON file path", "output.json")
  .action(async (options) => {
    const INTERVAL = 10 * 60 * 1000;
    const run = async () => {
      console.log(`[${new Date().toISOString()}] Running sync...`);
      try {
        await runCommand(options);
      } catch (err) {
        console.error(`Sync error: ${err.message}`);
      }
    };
    await run();
    setInterval(run, INTERVAL);
  });

program.parse();

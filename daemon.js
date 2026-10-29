#!/usr/bin/env node
// Standalone WeChat side for machines without OpenCode (or with OpenCode closed): `npx agent-wechat-bridge daemon`.
import { runDaemon } from "./index.js"

runDaemon()

import { Composer } from "grammy";
import type { MyContext } from "../types/context.js";

const composer = new Composer<MyContext>();

/**
 * FEATURE DISABLED: Lead processing is now handled manually.
 */

export const leadsHandlers = composer;

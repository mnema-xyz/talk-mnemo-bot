// Mnemo's slash commands, shared by the bot (registered at start) and the
// manifest (registered when an Owner adds Mnemo).
import { OptionType, Permissions, type CommandInput } from '@mnema-xyz/bot-sdk'

export const ASK_COMMAND: CommandInput = {
  name: 'ask',
  description: 'Ask Mnemo a question',
  options: [
    { name: 'question', description: 'What do you want to know?', type: OptionType.String, required: true },
    { name: 'private', description: 'Only you see the answer', type: OptionType.Boolean, required: false },
  ],
}

/** Admin-only: how the last public answer in this channel was made.
 * Restricted to administrators by default_member_permissions. */
export const DETAILS_COMMAND: CommandInput = {
  name: 'details',
  description: 'For Mnemo admins: how the last answer in this channel was made',
  default_member_permissions: Permissions.Administrator.toString(),
}

/** Mnemo registers both /ask and /details (/details is restricted to admins). */
export const COMMANDS: CommandInput[] = [ASK_COMMAND, DETAILS_COMMAND]

export function commandsFor(_adminUserIds?: readonly string[]): CommandInput[] {
  return COMMANDS
}

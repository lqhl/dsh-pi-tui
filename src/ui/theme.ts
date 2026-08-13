/**
 * pi-flavoured chalk theme. pi coding-agent renders the assistant in plain
 * terminal text with accent-blue prompts, dim reasoning, and compact tool
 * cards — reproduced here with pi-tui's theme functions.
 */
import chalk from 'chalk'
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
} from '@earendil-works/pi-tui'

const accent = chalk.hex('#4fc1ff')
const muted = chalk.hex('#8899aa')

export const markdownTheme: MarkdownTheme = {
  heading: (text) => chalk.bold.blue(text),
  link: (text) => chalk.underline.blue(text),
  linkUrl: (text) => chalk.dim(text),
  code: (text) => chalk.cyan(text),
  codeBlock: (text) => muted(text),
  codeBlockBorder: (text) => chalk.dim(text),
  quote: (text) => chalk.dim(text),
  quoteBorder: (text) => chalk.dim(text),
  hr: (text) => chalk.dim(text),
  listBullet: (text) => chalk.blue(text),
  bold: (text) => chalk.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
}

/** Dim italic pass for streamed reasoning text. */
export const reasoningMarkdownTheme: MarkdownTheme = {
  ...markdownTheme,
  italic: (text) => chalk.italic.dim(text),
}

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => accent('❯ '),
  selectedText: (text) => chalk.bold.blue(text),
  description: (text) => chalk.dim(text),
  scrollInfo: (text) => chalk.dim(text),
  noMatch: (text) => chalk.dim(text),
}

export const editorTheme: EditorTheme = {
  borderColor: (text) => chalk.dim(text),
  selectList: selectListTheme,
}

export const style = {
  accent,
  muted,
  userPrefix: (text: string) => accent('❯ '),
  userText: (text: string) => chalk.bold(text),
  thinkingLabel: (text: string) => chalk.dim.italic(text),
  toolName: (text: string) => chalk.cyan.bold(text),
  toolOk: (text: string) => chalk.green(text),
  toolError: (text: string) => chalk.red(text),
  toolBorder: (text: string) => chalk.dim(text),
  toolArgs: (text: string) => chalk.dim(text),
  toolResult: (text: string) => muted(text),
  statusBar: (text: string) => chalk.dim(text),
  spinner: (text: string) => chalk.blue(text),
  workingLabel: (text: string) => chalk.dim(text),
}

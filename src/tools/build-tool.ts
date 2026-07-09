/**
 * buildTool（L3-M3 §2.2.1）
 *
 * 工具构造器：统一 fail-closed 默认值 + 描述截断（不变量 #15）。
 */

import type {
  JSONSchema,
  PermissionDecision,
  Tool,
  ToolContext,
  ToolInput,
  ToolResult,
} from '../types/index.js';

export interface BuildToolParams {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  isReadOnly?: boolean;
  isDestructive?: boolean;
  isConcurrencySafe?: boolean;
  isBackground?: boolean;
  checkPermissions: (input: ToolInput) => PermissionDecision;
  call: (input: ToolInput, ctx: ToolContext) => Promise<ToolResult>;
}

export function buildTool(params: BuildToolParams): Tool {
  // 描述截断（不变量 #15：description ≤ 2048 字符）
  const description =
    params.description.length > 2048
      ? params.description.slice(0, 2048) + '...[truncated]'
      : params.description;

  return {
    name: params.name,
    description,
    inputSchema: params.inputSchema,
    // fail-closed 默认值（L3-M3 §2.2.1）
    isReadOnly: params.isReadOnly ?? false,
    isDestructive: params.isDestructive ?? true,
    isConcurrencySafe: params.isConcurrencySafe ?? false,
    isBackground: params.isBackground ?? false,
    checkPermissions: params.checkPermissions,
    call: params.call,
  };
}

/** helper：构造成功的 ToolResult */
export function okResult(
  toolUseId: ToolResult['tool_use_id'],
  text: string,
  extra: { compactable?: boolean; duration_ms: number },
): ToolResult {
  return {
    tool_use_id: toolUseId,
    content: [{ type: 'text', text }],
    is_error: false,
    metadata: extra,
  };
}

/** helper：构造失败的 ToolResult */
export function errorResult(
  toolUseId: ToolResult['tool_use_id'],
  message: string,
  extra: { duration_ms: number },
): ToolResult {
  return {
    tool_use_id: toolUseId,
    content: [{ type: 'text', text: message }],
    is_error: true,
    metadata: extra,
  };
}

// facility module: database — migration immutability (PreToolUse)
if (/(^|\/)(supabase\/|db\/|prisma\/)?migrations\/[^/]+\.(sql|js|ts|rb|py)$/.test(filePath)) {
  const tool = payload?.tool_name ?? "";
  const isEdit = tool === "Edit" || tool === "MultiEdit";
  if (isEdit) {
    block(
      "Migration files are immutable once written. Create a NEW timestamped migration instead.",
    );
  }
}

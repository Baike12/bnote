/** The permission modes of the composer (ZCode's selector shape). */
export const PERMISSION_MODES: {
  id: "confirm" | "auto" | "full" | "plan";
  label: string;
  description: string;
}[] = [
  { id: "confirm", label: "变更前确认", description: "改文件、跑命令前先问我。" },
  { id: "auto", label: "自主模式", description: "在有风险时询问。" },
  { id: "full", label: "完全访问", description: "减少确认次数。" },
  { id: "plan", label: "计划模式", description: "只读调研;计划经你批准后才开始改文件。" },
];

export function ShieldIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5 5 6v5.2c0 4.2 2.9 7.6 7 9.3 4.1-1.7 7-5.1 7-9.3V6l-7-2.5Z" />
    </svg>
  );
}

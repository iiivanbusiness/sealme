"use client";

import { useState, useTransition } from "react";

type RoleOption = { id: string; name: string };

export default function RoleSelect({
  userId,
  currentRoleId,
  roles,
  action,
  disabled,
}: {
  userId: string;
  currentRoleId: string | null;
  roles: RoleOption[];
  action: (userId: string, formData: FormData) => Promise<{ error?: string }>;
  disabled?: boolean;
}) {
  const [value, setValue] = useState(currentRoleId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleChange(nextRoleId: string) {
    const previous = value;
    setValue(nextRoleId);
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("roleId", nextRoleId);
      const result = await action(userId, formData);
      if (result.error) {
        setValue(previous);
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <select
        value={value}
        disabled={disabled || isPending}
        onChange={(e) => handleChange(e.target.value)}
        className="input"
        style={{ fontSize: "12.5px", padding: "5px 8px", width: "auto" }}
      >
        {/* Invited and SCIM teammates start with no role. Without this
            the browser shows the first role (Owner) as picked, and picking
            it never fires onChange. */}
        {!value && <option value="" disabled>No role</option>}
        {roles.map((role) => (
          <option key={role.id} value={role.id}>
            {role.name}
          </option>
        ))}
      </select>
      {error && (
        <span className="max-w-[220px] text-right text-[11px]" style={{ color: "#c0392b" }}>
          {error}
        </span>
      )}
    </div>
  );
}

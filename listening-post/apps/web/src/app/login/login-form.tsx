"use client";

import { useActionState } from "react";
import { inputClass, primaryButtonClass } from "@/components/ui";
import { loginAction, type LoginState } from "./actions";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium">
          Admin password
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus className={inputClass} />
      </div>
      {state.error && (
        <p role="alert" id="login-error" className="text-sm text-red-700 dark:text-red-400">
          {state.error}
        </p>
      )}
      <button type="submit" className={primaryButtonClass} disabled={pending}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

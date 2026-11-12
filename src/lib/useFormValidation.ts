import { useState } from "react";

export function useFormValidation(validation: Readonly<Record<string, string | undefined>>) {
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const errors = Object.fromEntries(Object.entries(validation).filter(([key, error]) => error && touched[key]));
  return {
    errors,
    invalid: Object.values(validation).some(Boolean),
    touch: (key: string) => setTouched((previous) => ({ ...previous, [key]: true })),
    reset: () => setTouched({}),
  };
}

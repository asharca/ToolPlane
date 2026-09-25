// Source: asharca/ui 85b080aafe2f7e3aaf720e5a2ffdf035289c49c1/lib/utils.ts (MIT). See provenance.json.
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

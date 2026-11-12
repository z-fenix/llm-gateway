import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const ALL = "__all__";

export default function FilterSelect({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return <Select value={value || ALL} onValueChange={next => onChange(next === ALL ? "" : next)}>
    <SelectTrigger aria-label={label} className="w-full min-w-32 sm:w-auto sm:max-w-64"><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value || ALL}>{option.label}</SelectItem>)}</SelectContent>
  </Select>;
}

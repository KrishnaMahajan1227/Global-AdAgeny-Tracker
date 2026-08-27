import { Input, Combobox } from '@/components/ui';
import { INDIA_STATES, INDIA_CITIES_BY_STATE, ALL_INDIA_CITIES } from '@/lib/indiaLocations';

export interface ShopFormValues {
  name: string;
  owner_name: string;
  contact_phone: string;
  address: string;
  village: string;
  city: string;
  district: string;
  zone: string;
  state: string;
}

export const emptyShopFormValues: ShopFormValues = {
  name: '', owner_name: '', contact_phone: '', address: '', village: '', city: '', district: '', zone: '', state: '',
};

// Village is deliberately the only optional-looking field with no
// asterisk callout beyond the shared "required" convention — every other
// location/contact field is free-text-optional too, but Name is the only
// one actually required to save a record.
export function ShopForm({ form, setForm }: { form: ShopFormValues; setForm: (f: ShopFormValues) => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Input label="Shop / Site Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <Input label="Owner Name" value={form.owner_name} onChange={(v) => setForm({ ...form, owner_name: v })} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Input label="Contact Phone" value={form.contact_phone} onChange={(v) => setForm({ ...form, contact_phone: v })} placeholder="+91 90000 00000" />
        <Input label="Zone" value={form.zone} onChange={(v) => setForm({ ...form, zone: v })} placeholder="e.g. North Zone" />
      </div>
      <Input label="Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} />
      <div className="grid grid-cols-2 gap-4">
        <Input label="Village (optional)" value={form.village} onChange={(v) => setForm({ ...form, village: v })} />
        <Combobox label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} options={form.state && INDIA_CITIES_BY_STATE[form.state] ? INDIA_CITIES_BY_STATE[form.state] : ALL_INDIA_CITIES} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Input label="District" value={form.district} onChange={(v) => setForm({ ...form, district: v })} />
        <Combobox label="State" value={form.state} onChange={(v) => setForm({ ...form, state: v })} options={INDIA_STATES} />
      </div>
    </div>
  );
}

import { Input, Combobox } from '@/components/ui';
import { INDIA_STATES, INDIA_CITIES_BY_STATE, ALL_INDIA_CITIES } from '@/lib/indiaLocations';

export interface ShopFormValues {
  name: string;
  owner_name: string; // historical owner name, retained on edits
  contact_person_name: string;
  owner_phone: string;
  contact_phone: string;
  address: string;
  village: string;
  city: string;
  district: string;
  taluka: string;
  pincode: string;
  zone: string;
  state: string;
}

export const emptyShopFormValues: ShopFormValues = {
  name: '', owner_name: '', contact_person_name: '', owner_phone: '', contact_phone: '', address: '', village: '', city: '', district: '', taluka: '', pincode: '', zone: '', state: '',
};

// Client form shares the same location fields as the universal Excel importer.
// Address is necessary for usable location searches; city/taluka/district remain optional.
export function ShopForm({ form, setForm }: { form: ShopFormValues; setForm: (f: ShopFormValues) => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <Input label="Shop / Site Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} required />
        <Input label="Owner Number (optional)" value={form.owner_phone} onChange={(v) => setForm({ ...form, owner_phone: v })} placeholder="e.g. +91 98765 43210" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Input label="Officer Name (optional)" value={form.contact_person_name} onChange={(v) => setForm({ ...form, contact_person_name: v })} placeholder="Person to contact on site" />
        <Input label="Officer Number (optional)" value={form.contact_phone} onChange={(v) => setForm({ ...form, contact_phone: v })} placeholder="+91 90000 00000" />
        <Input label="Zone" value={form.zone} onChange={(v) => setForm({ ...form, zone: v })} placeholder="e.g. North Zone" />
      </div>
      <Input label="Full Address" value={form.address} onChange={(v) => setForm({ ...form, address: v })} placeholder="Shop/building, road/locality, landmark, PIN if known" required />
      <div className="grid grid-cols-2 gap-4">
        <Input label="Village (optional)" value={form.village} onChange={(v) => setForm({ ...form, village: v })} />
        <Combobox label="City (optional)" value={form.city} onChange={(v) => setForm({ ...form, city: v })} options={form.state && INDIA_CITIES_BY_STATE[form.state] ? INDIA_CITIES_BY_STATE[form.state] : ALL_INDIA_CITIES} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Input label="District (optional)" value={form.district} onChange={(v) => setForm({ ...form, district: v })} />
        <Combobox label="State (optional)" value={form.state} onChange={(v) => setForm({ ...form, state: v })} options={INDIA_STATES} />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Input label="Taluka / Tehsil (optional)" value={form.taluka} onChange={(v) => setForm({ ...form, taluka: v })} />
        <div />
      </div>
    </div>
  );
}

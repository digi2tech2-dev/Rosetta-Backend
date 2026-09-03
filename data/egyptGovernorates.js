// Canonical shipping governorates. These values are persisted on shipping
// rules and must be sent unchanged by checkout clients.
const egyptGovernorates = [
  ["القاهرة", "Cairo"], ["الجيزة", "Giza"], ["الإسكندرية", "Alexandria"],
  ["القليوبية", "Qalyubia"], ["الدقهلية", "Dakahlia"], ["البحيرة", "Beheira"],
  ["الشرقية", "Sharqia"], ["الغربية", "Gharbia"], ["المنوفية", "Monufia"],
  ["دمياط", "Damietta"], ["بورسعيد", "Port Said"], ["الإسماعيلية", "Ismailia"],
  ["السويس", "Suez"], ["كفر الشيخ", "Kafr El Sheikh"], ["الفيوم", "Faiyum"],
  ["بني سويف", "Beni Suef"], ["المنيا", "Minya"], ["أسيوط", "Asyut"],
  ["سوهاج", "Sohag"], ["قنا", "Qena"], ["الأقصر", "Luxor"], ["أسوان", "Aswan"],
  ["مطروح", "Matrouh"], ["البحر الأحمر", "Red Sea"], ["الوادي الجديد", "New Valley"],
  ["شمال سيناء", "North Sinai"], ["جنوب سيناء", "South Sinai"],
].map(([value, en]) => ({ value, labels: { ar: value, en } }));

function governorateComparisonKey(value) {
  return String(value || "")
    .trim()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/^مدينة\s+/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function canonicalGovernorate(value) {
  const raw = String(value || "").trim();
  const matchingGovernorate = egyptGovernorates.find(
    (governorate) => governorateComparisonKey(governorate.value) === governorateComparisonKey(raw),
  );
  return matchingGovernorate?.value || raw;
}

module.exports = { egyptGovernorates, governorateComparisonKey, canonicalGovernorate };

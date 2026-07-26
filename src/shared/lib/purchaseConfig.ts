export type PurchaseTier = "personal" | "commercial";
export type PurchaseSource =
  "onboarding" | "settings_account" | "sidebar_lock" | "trial_toast";

export type TierInfo = {
  id: PurchaseTier;
  label: string;
  price: string;
  pickerPrice?: string;
  blurb: string;
};

export function tierInfo(tier: PurchaseTier): TierInfo {
  if (tier === "commercial") {
    return {
      id: "commercial",
      label: "Commercial",
      price: "$48/seat/year",
      pickerPrice: "per seat",
      blurb:
        "For paid work. One seat per person on one work device, billed yearly. Volume discounts for teams.",
    };
  }
  return {
    id: "personal",
    label: "Personal",
    price: "$24.99",
    pickerPrice: "$24.99",
    blurb: "For yourself. A one-time purchase, on up to 5 of your own devices.",
  };
}

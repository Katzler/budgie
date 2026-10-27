// Fyll i från Supabase → Project Settings → API (och README för VAPID).
// Nycklarna här är publika: databasen skyddas av Row Level Security.
// Lämnas SUPABASE_URL tom körs appen i demoläge med påhittad data.
export const config = {
  SUPABASE_URL: "https://cojuuewwzpdkbwtrgafa.supabase.co",
  SUPABASE_KEY: "sb_publishable_QVoObeyl8PpW9XQAW7oH7w_xPgZ8AOd", // publishable/anon key, aldrig service role!
  VAPID_PUBLIC_KEY: "BM0s3ye88lElHgsPgSjN6-z3YpEprJrrHARzqKjexhKcVusKNEO3rr0Hqebt4GWRDtYRgAJYERZCpMBj7nYAvq4",
};

-- A phone number on a registration.
--
-- Hosts follow up by phone, and a webinar registration that captures an email address and
-- not a number leaves them exporting a CSV and asking for the missing half afterwards.
--
-- Stored as ONE text column in E.164 shape (`+<country><subscriber>`, digits only after the
-- plus), not as a dial code and a national number in two columns. The split is a property of
-- the form, not of the number: a number typed as "+91 98765 43210" and one assembled from a
-- +91 picker and "9876543210" are the same number, and keeping them apart in the schema means
-- every reader has to reassemble them and every writer has to agree on how. E.164 is also
-- what a dialler, an SMS gateway and a CRM all expect.
--
-- NOT NULL DEFAULT '' rather than nullable, matching the other optional fields in this table
-- (company, job_title, country). An absent number is an empty string, so no reader has to
-- handle NULL, and the existing rows are backfilled by the default without a rewrite.
ALTER TABLE registrations ADD COLUMN phone text NOT NULL DEFAULT '';

-- No index. Nothing looks a registration up by number: the lookup keys are the join key and
-- (webinar, email), both already indexed. An index here would cost writes on the busiest
-- insert path in the product to serve a query nobody makes.

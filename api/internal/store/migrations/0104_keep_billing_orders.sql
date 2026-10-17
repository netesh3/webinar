/* Billing orders outlive the account.
 *
 * An order is an invoice record, and tax law (GST) requires keeping those for
 * years: a legal-obligation exception to erasing an account. 0100 made
 * billing_orders.user_id ON DELETE CASCADE, so deleting an account deleted its
 * payment history. It is now nullable and SET NULL: the order stays, unlinked.
 * A payment that arrives for such an order is recorded and not granted
 * (store.ErrAccountGone).
 */
ALTER TABLE billing_orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE billing_orders DROP CONSTRAINT billing_orders_user_id_fkey;
ALTER TABLE billing_orders ADD CONSTRAINT billing_orders_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;

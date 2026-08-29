CREATE TABLE "_MarketListingCategories" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_MarketListingCategories_AB_pkey" PRIMARY KEY ("A", "B")
);

CREATE INDEX "_MarketListingCategories_B_index" ON "_MarketListingCategories"("B");

ALTER TABLE "_MarketListingCategories"
  ADD CONSTRAINT "_MarketListingCategories_A_fkey"
  FOREIGN KEY ("A") REFERENCES "Category"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_MarketListingCategories"
  ADD CONSTRAINT "_MarketListingCategories_B_fkey"
  FOREIGN KEY ("B") REFERENCES "MarketListing"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "_ToolkitCategories" (
  "A" TEXT NOT NULL,
  "B" TEXT NOT NULL,
  CONSTRAINT "_ToolkitCategories_AB_pkey" PRIMARY KEY ("A", "B")
);

CREATE INDEX "_ToolkitCategories_B_index" ON "_ToolkitCategories"("B");

ALTER TABLE "_ToolkitCategories"
  ADD CONSTRAINT "_ToolkitCategories_A_fkey"
  FOREIGN KEY ("A") REFERENCES "Category"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "_ToolkitCategories"
  ADD CONSTRAINT "_ToolkitCategories_B_fkey"
  FOREIGN KEY ("B") REFERENCES "Toolkit"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

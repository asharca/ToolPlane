-- Remove the Hub favorites feature: drop the User<->Server implicit M2M join table.
-- DropTable
DROP TABLE "_UserHubServers";

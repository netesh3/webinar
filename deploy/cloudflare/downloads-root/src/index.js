// GET https://downloads.webinarliv.com/ — R2 has no index document, so this
// Worker (route: the hostname with no path wildcard, which matches only /)
// sends people to the site download page. Installers stay on the R2 custom domain.
const DOWNLOAD_PAGE = "https://webinarliv.com/download";

export default {
  async fetch() {
    return Response.redirect(DOWNLOAD_PAGE, 302);
  },
};

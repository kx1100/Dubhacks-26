#include "geo/canvas.h"
#include "geo/shape.h"
#include "../c/logger.h"

static void addDefaults(std::vector<std::unique_ptr<geo::Shape>>& shapes) {
    shapes.push_back(geo::makeShape("circle"));
    shapes.push_back(geo::makeShape("rect"));
}

int main(int argc, char** argv) {
    log_init("app.log");
    std::vector<std::unique_ptr<geo::Shape>> shapes;
    addDefaults(shapes);
    geo::Canvas canvas;
    canvas.render(shapes);
    geo::Circle* c = new geo::Circle({1, 2}, 3);
    double total = c->area();
    log_message(LOG_INFO, "done");
    log_close();
    return total > 0 ? 0 : 1;
}

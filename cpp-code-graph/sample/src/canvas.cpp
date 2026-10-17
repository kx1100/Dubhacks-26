#include "geo/canvas.h"
#include "../c/logger.h"

using namespace geo;

void Canvas::plot(int x, int y) {
    pixels_.push_back(Point{double(x), double(y)});
}

void Canvas::line(Point a, Point b) {
    plot(int(a.x), int(a.y));
    plot(int(b.x), int(b.y));
}

void Canvas::render(const std::vector<std::unique_ptr<Shape>>& shapes) {
    for (const auto& s : shapes) {
        log_message(LOG_INFO, s->name().c_str());
        s->draw(*this);
    }
}

int Canvas::pixelCount() const { return static_cast<int>(pixels_.size()); }
